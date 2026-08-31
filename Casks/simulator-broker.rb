cask "simulator-broker" do
  version "0.1.0-alpha.4"
  sha256 "d44c4ba8318338c5e009ed2e71aa6fea03e6167698a4a60df7ce5b865f5e3963"

  url "https://github.com/fiveonecode/simulator-broker/releases/download/v#{version}/Simulator-Broker-#{version}.zip"
  name "Simulator Broker"
  desc "macOS operator app for the local iOS Simulator control plane"
  homepage "https://github.com/fiveonecode/simulator-broker"

  depends_on macos: :sonoma

  app "Simulator Broker.app"

  caveats <<~EOS
    This cask installs Simulator Broker.app from the signed, notarized
    GitHub Release zip Simulator-Broker-#{version}.zip. Reproduce that
    zip from payload/app/Simulator Broker.app after
    npm run package:distribution (Developer ID Application + notarization)
    and npm run package:cask-zip.
  EOS
end
