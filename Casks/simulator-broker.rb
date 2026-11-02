cask "simulator-broker" do
  version "0.1.0-alpha.14"
  sha256 "82e69c2f8c01a74ba75911235c9ba5dcadcebacbc789cf3fa86d964ba5ee8b7d"

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
