class Simbroker < Formula
  desc "Local iOS Simulator control plane CLI"
  homepage "https://github.com/fiveonecode/simulator-broker"
  url "https://github.com/fiveonecode/simulator-broker/releases/download/v0.1.0-alpha.15/simulator-broker-0.1.0-alpha.15-cli.tar.gz"
  sha256 "0e34a74457f934cfe83508f175211ca0bfb4c67c589e614709d02e018dcbf9ab"
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
