class Simbroker < Formula
  desc "Local iOS Simulator control plane CLI"
  homepage "https://github.com/fiveonecode/simulator-broker"
  url "https://github.com/fiveonecode/simulator-broker/releases/download/v0.1.0-alpha.7/simulator-broker-0.1.0-alpha.7-cli.tar.gz"
  sha256 "0361b3526823f4124c6f54453680fbce2c0a4a2064779b91774038c42b3ade45"
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
