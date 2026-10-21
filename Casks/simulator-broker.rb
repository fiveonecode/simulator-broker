cask "simulator-broker" do
  version "0.1.0-alpha.10"
  sha256 "5647668afe88614ba798b6f0b9bd44d48763cc3153094157dab6dad15d3facb8"

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
