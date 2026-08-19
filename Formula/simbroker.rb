class Simbroker < Formula
  desc "Local iOS Simulator control plane CLI"
  homepage "https://github.com/fiveonecode/simulator-broker"
  url "https://github.com/fiveonecode/simulator-broker/releases/download/v0.1.0-alpha.1/simulator-broker-0.1.0-alpha.1-cli.tar.gz"
  sha256 "699695bc65a5bcb25b9c9b5d01494fcc3f25a40dcc90b8b5bf1ec61ea87a8522"
  license "MIT"

  depends_on :macos
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
