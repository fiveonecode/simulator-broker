class Simbroker < Formula
  desc "Local iOS Simulator control plane CLI"
  homepage "https://github.com/fiveonecode/simulator-broker"
  url "https://github.com/fiveonecode/simulator-broker/releases/download/v0.1.0-alpha.5/simulator-broker-0.1.0-alpha.5-cli.tar.gz"
  sha256 "429c6477ff3a85f90a660693bda5527963a89942a8e8052eee31086a5ecc3ddd"
  license "MIT"

  depends_on macos: :sonoma
  depends_on "node"

  def install
    libexec.install Dir["*"]
    (bin/"simbroker").write <<~SH
      #!/bin/bash
      exec "#{formula_opt_bin("node")}/node" "#{libexec}/client/bin/simbroker.mjs" "$@"
    SH
  end

  test do
    assert_match "simbroker", shell_output("#{bin}/simbroker --help")
  end
end
