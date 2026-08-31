import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const tarBlockSize = 512;

function assertExpectedRoot(expectedRoot) {
  assert.equal(typeof expectedRoot, "string", "CLI tar root must be a string");
  assert.notEqual(expectedRoot, "", "CLI tar root must not be empty");
  assert.notEqual(expectedRoot, ".", "CLI tar root must not be dot");
  assert.notEqual(expectedRoot, "..", "CLI tar root must not be dot-dot");
  assert.equal(/[\\/\0]/.test(expectedRoot), false, "CLI tar root must be one safe path segment");
}

function tarHeaderText(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString("utf8");
}

function tarHeaderOctal(header, offset, length, fieldName, entryName) {
  const value = tarHeaderText(header, offset, length).trim();
  assert.match(value, /^[0-7]+$/, `${entryName} has invalid ${fieldName} tar header value`);
  return Number.parseInt(value, 8);
}

export function parsePaxRecords(payload, entryName) {
  const records = [];
  let offset = 0;

  while (offset < payload.length) {
    const separator = payload.indexOf(0x20, offset);
    assert.notEqual(separator, -1, `${entryName} has a malformed PAX record length`);
    const lengthText = payload.subarray(offset, separator).toString("ascii");
    assert.match(lengthText, /^[1-9][0-9]*$/, `${entryName} has a malformed PAX record length`);
    const recordEnd = offset + Number.parseInt(lengthText, 10);
    assert.ok(recordEnd <= payload.length, `${entryName} has a truncated PAX record`);
    assert.equal(payload[recordEnd - 1], 0x0a, `${entryName} PAX record must end with a newline`);

    const record = payload.subarray(separator + 1, recordEnd - 1).toString("utf8");
    const equals = record.indexOf("=");
    assert.ok(equals > 0, `${entryName} has a malformed PAX key/value record`);
    records.push({ key: record.slice(0, equals), value: record.slice(equals + 1) });
    offset = recordEnd;
  }

  return records;
}

export function readRawTarEntries(tarball) {
  const archive = gunzipSync(fs.readFileSync(tarball));
  assert.equal(archive.length % tarBlockSize, 0, "CLI tarball must contain complete 512-byte blocks");
  const entries = [];
  let offset = 0;
  let foundTrailer = false;

  while (offset + tarBlockSize <= archive.length) {
    const header = archive.subarray(offset, offset + tarBlockSize);
    if (header.every((byte) => byte === 0)) {
      assert.ok(
        archive.length - offset >= tarBlockSize * 2,
        "CLI tarball must end with two zero blocks",
      );
      assert.ok(
        archive.subarray(offset).every((byte) => byte === 0),
        "CLI tarball has non-zero data after its zero-block trailer",
      );
      foundTrailer = true;
      break;
    }

    const name = tarHeaderText(header, 0, 100);
    const prefix = tarHeaderText(header, 345, 155);
    const entryName = prefix ? `${prefix}/${name}` : name;
    const size = tarHeaderOctal(header, 124, 12, "size", entryName);
    const storedChecksum = tarHeaderOctal(header, 148, 8, "checksum", entryName);
    const computedChecksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 0x20 : byte),
      0,
    );
    assert.equal(storedChecksum, computedChecksum, `${entryName} has an invalid tar header checksum`);

    const payloadStart = offset + tarBlockSize;
    const payloadEnd = payloadStart + size;
    assert.ok(payloadEnd <= archive.length, `${entryName} extends beyond the CLI tarball`);
    const typeFlag = String.fromCharCode(header[156] || 0x30);
    const payload = archive.subarray(payloadStart, payloadEnd);
    entries.push({
      gid: tarHeaderOctal(header, 116, 8, "gid", entryName),
      gname: tarHeaderText(header, 297, 32),
      magic: header.subarray(257, 263).toString("latin1"),
      name: entryName,
      paxRecords: typeFlag === "x" || typeFlag === "g" ? parsePaxRecords(payload, entryName) : [],
      typeFlag,
      uid: tarHeaderOctal(header, 108, 8, "uid", entryName),
      uname: tarHeaderText(header, 265, 32),
      version: header.subarray(263, 265).toString("latin1"),
    });
    offset = payloadStart + Math.ceil(size / tarBlockSize) * tarBlockSize;
  }

  assert.equal(foundTrailer, true, "CLI tarball must end with a zero-block trailer");
  return entries;
}

export function assertPortableCliTarEntries(entries, expectedRoot) {
  assertExpectedRoot(expectedRoot);
  assert.ok(entries.length > 0, "CLI tarball must contain payload entries");
  assert.equal(new Set(entries.map((entry) => entry.name)).size, entries.length, "CLI tar paths must be unique");

  for (const entry of entries) {
    assert.ok(["0", "5"].includes(entry.typeFlag), `CLI tar contains non-payload type ${entry.typeFlag}: ${entry.name}`);
    assert.equal(
      entry.name.endsWith("/") && entry.typeFlag !== "5",
      false,
      `only CLI tar directories may have a trailing slash: ${entry.name}`,
    );
    const normalizedName = entry.name.endsWith("/") ? entry.name.slice(0, -1) : entry.name;
    const segments = normalizedName.split("/");
    assert.equal(segments[0], expectedRoot, `CLI tar entry must stay under ${expectedRoot}: ${entry.name}`);
    assert.equal(
      segments.some((segment) => segment === "" || segment === "." || segment === ".."),
      false,
      `CLI tar contains an unsafe path segment: ${entry.name}`,
    );
    assert.deepEqual(entry.paxRecords, [], `CLI tar contains PAX metadata: ${entry.name}`);
    assert.equal(
      segments.some((segment) => segment.startsWith("._")),
      false,
      `CLI tar contains AppleDouble metadata: ${entry.name}`,
    );
    assert.equal(entry.magic, "ustar\0", `${entry.name} must use exact POSIX USTAR magic`);
    assert.equal(entry.version, "00", `${entry.name} must use exact POSIX USTAR version 00`);
    assert.equal(entry.uid, 0, `${entry.name} must have normalized uid 0`);
    assert.equal(entry.gid, 0, `${entry.name} must have normalized gid 0`);
    assert.equal(entry.uname, "", `${entry.name} must not expose a host user name`);
    assert.equal(entry.gname, "", `${entry.name} must not expose a host group name`);
  }

  const rootEntries = entries.filter(
    (entry) => entry.name === expectedRoot || entry.name === `${expectedRoot}/`,
  );
  assert.equal(rootEntries.length, 1, `CLI tarball must contain exactly one ${expectedRoot} root entry`);
  assert.equal(rootEntries[0].typeFlag, "5", "CLI tarball root entry must be a directory");
}

export function validatePortableCliTar(tarball, expectedRoot) {
  const entries = readRawTarEntries(tarball);
  assertPortableCliTarEntries(entries, expectedRoot);
  return entries;
}

const invokedAsProgram = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsProgram) {
  try {
    assert.equal(process.argv.length, 4, "validator requires a tarball and expected root");
    validatePortableCliTar(process.argv[2], process.argv[3]);
  } catch {
    process.stderr.write("CLI tar validation failed: archive violates the portable USTAR contract.\n");
    process.exitCode = 1;
  }
}
