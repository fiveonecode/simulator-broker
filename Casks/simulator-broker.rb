cask "simulator-broker" do
  version "0.1.0-alpha.1"
  sha256 "5e19d128bf8061d5e18812c092e8a3b8e5f4514ff42bc233baa643fb0f075f70"

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
