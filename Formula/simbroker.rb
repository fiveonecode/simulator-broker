class Simbroker < Formula
  desc "Local iOS Simulator control plane CLI"
  homepage "https://github.com/fiveonecode/simulator-broker"
  url "https://github.com/fiveonecode/simulator-broker/releases/download/v0.1.0-alpha.14/simulator-broker-0.1.0-alpha.14-cli.tar.gz"
  sha256 "5d3c92c880f4e58babbf8ce43c864e0cca9d4ad524ab6ea4bc59239f920277c8"
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
