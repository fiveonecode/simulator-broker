cask "simulator-broker" do
  version "0.1.0-alpha.7"
  sha256 "fa619298228a4312a11b87391f9b19593ae1a17b54e9ccd5ce0c9afb902a21a3"

  url "https://github.com/fiveonecode/simulator-broker/releases/download/v#{version}/Simulator-Broker-#{version}.zip"
  name "Simulator Broker"
  desc "Operator app for the local iOS Simulator control plane"
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
