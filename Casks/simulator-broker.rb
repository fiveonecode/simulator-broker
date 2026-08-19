cask "simulator-broker" do
  version "0.1.0-alpha.2"
  sha256 "1135d767cb6eb4944ed389f7b57af808b7046b00078875bef79ad50ee14c6e40"

  url "https://github.com/fiveonecode/simulator-broker/releases/download/v#{version}/Simulator-Broker-#{version}.zip"
  name "Simulator Broker"
  desc "macOS operator app for the local iOS Simulator control plane"
  homepage "https://github.com/fiveonecode/simulator-broker"

  depends_on macos: :ventura

  app "Simulator Broker.app"

  caveats <<~EOS
    This cask installs Simulator Broker.app from the signed, notarized
    GitHub Release zip Simulator-Broker-#{version}.zip. Reproduce that
    zip from payload/app/Simulator Broker.app after
    npm run package:distribution (Developer ID Application + notarization).
  EOS
end
