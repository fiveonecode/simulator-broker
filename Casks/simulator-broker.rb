cask "simulator-broker" do
  version "0.1.0-alpha.1"
  sha256 :no_check

  url "https://github.com/fiveonecode/simulator-broker/releases/download/v#{version}/Simulator-Broker-#{version}.zip"
  name "Simulator Broker"
  desc "macOS operator app for the local iOS Simulator control plane"
  homepage "https://github.com/fiveonecode/simulator-broker"

  depends_on macos: :ventura

  app "Simulator Broker.app"

  caveats <<~EOS
    This cask installs Simulator Broker.app from the signed, notarized
    GitHub Release zip Simulator-Broker-#{version}.zip. Produce that zip
    with npm run package:distribution (Developer ID Application + notarytool),
    using payload/app/Simulator Broker.app from the distribution bundle.
    The current Alpha GitHub Release attaches the CLI tarball, not this zip.
  EOS
end
