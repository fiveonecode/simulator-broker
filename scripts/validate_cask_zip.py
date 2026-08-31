#!/usr/bin/env python3
import stat
import sys
import zipfile


class ContractError(Exception):
    pass


def reject(message):
    raise ContractError(message)


def validate_name(name, expected_root, index):
    label = f"entry {index}"
    if not name or name.startswith("/") or "\\" in name or "\0" in name:
        reject(f"{label} has an unsafe name")
    directory = name.endswith("/")
    normalized = name[:-1] if directory else name
    segments = normalized.split("/")
    if any(segment in {"", ".", ".."} for segment in segments):
        reject(f"{label} has an unsafe path segment")
    if segments[0] != expected_root:
        reject(f"{label} is outside the app root")
    if any(segment.upper() == "__MACOSX" for segment in segments):
        reject(f"{label} contains __MACOSX metadata")
    if any(segment.startswith("._") for segment in segments):
        reject(f"{label} contains AppleDouble metadata")
    return directory


def validate_cask_zip(zip_path, expected_root):
    if not expected_root or expected_root in {".", ".."} or any(
        separator in expected_root for separator in ("/", "\\", "\0")
    ):
        reject("expected root must be one safe path segment")

    with zipfile.ZipFile(zip_path) as archive:
        if archive.comment:
            reject("archive comments are unsupported")
        entries = archive.infolist()
        if not entries:
            reject("archive is empty")
        names = [entry.orig_filename for entry in entries]
        if len(set(names)) != len(names):
            reject("entry names must be unique")

        root_entries = []
        regular_descendants = 0
        for index, entry in enumerate(entries, start=1):
            if entry.orig_filename != entry.filename:
                reject(f"entry {index} has an ambiguous NUL-suffixed name")
            directory = validate_name(entry.orig_filename, expected_root, index)
            if entry.comment:
                reject(f"entry {index} has an unsupported comment")
            if entry.flag_bits & (0x1 | 0x40):
                reject(f"entry {index} is encrypted")
            if entry.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
                reject(f"entry {index} uses unsupported compression")
            if entry.create_system != 3:
                reject(f"entry {index} lacks Unix file attributes")

            file_type = stat.S_IFMT((entry.external_attr >> 16) & 0xFFFF)
            if directory:
                if file_type != stat.S_IFDIR:
                    reject(f"entry {index} is not a directory")
            elif file_type == stat.S_IFREG:
                regular_descendants += 1
            else:
                reject(f"entry {index} has an unsupported file type")

            if entry.orig_filename in {expected_root, f"{expected_root}/"}:
                root_entries.append((entry, directory))

            with archive.open(entry) as payload:
                while payload.read(1024 * 1024):
                    pass

        if len(root_entries) != 1 or not root_entries[0][1]:
            reject("archive must contain exactly one app root directory")
        if regular_descendants == 0:
            reject("archive must contain a regular app payload file")
        required_entries = {
            f"{expected_root}/Contents/Info.plist",
            f"{expected_root}/Contents/MacOS/SimulatorBrokerApp",
            f"{expected_root}/Contents/CodeResources",
            f"{expected_root}/Contents/_CodeSignature/CodeResources",
        }
        if not required_entries.issubset(names):
            reject("archive is missing an essential signed-app payload entry")


def main():
    if len(sys.argv) != 3:
        sys.stderr.write("Cask ZIP validation failed: expected a ZIP and app root.\n")
        return 1
    try:
        validate_cask_zip(sys.argv[1], sys.argv[2])
    except ContractError as error:
        sys.stderr.write(f"Cask ZIP validation failed: {error}.\n")
        return 1
    except Exception:
        sys.stderr.write("Cask ZIP validation failed: archive is unreadable or unsupported.\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
