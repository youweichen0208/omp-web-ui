/** Reviewed upgrade input; runtime downloads must match these committed hashes.
 * Refresh candidates with scripts/review-native-toolchain-pins.mjs; never auto-update. */
export const nativeToolchainPins = {
	schema: 1,
	versions: {
		java: "1.61.0",
		go: "0.21.1",
		rust: "2026-09-28",
		cpp: "23.1.0",
		jdk: "jdk-21.0.12.1+1",
	},
	assets: {
		"rust-analyzer-aarch64-apple-darwin.gz": {
			url: "https://github.com/rust-lang/rust-analyzer/releases/download/2026-09-28/rust-analyzer-aarch64-apple-darwin.gz",
			sha256:
				"54ec873d8996e2c127d758bf45d4eacb6d3371dae4f6f6d5d3f05cedbae5fd59",
		},
		"rust-analyzer-aarch64-pc-windows-msvc.zip": {
			url: "https://github.com/rust-lang/rust-analyzer/releases/download/2026-09-28/rust-analyzer-aarch64-pc-windows-msvc.zip",
			sha256:
				"f63c7fc9a00a7e863b21b5e0b77cda7ff61aaa9f6f83b0affa5bbb525be7c43c",
		},
		"rust-analyzer-aarch64-unknown-linux-gnu.gz": {
			url: "https://github.com/rust-lang/rust-analyzer/releases/download/2026-09-28/rust-analyzer-aarch64-unknown-linux-gnu.gz",
			sha256:
				"03bad9c3dabb0f07a2678d5f9f8f1575a3742ea141506e14b3a26b42a1f896f3",
		},
		"rust-analyzer-x86_64-apple-darwin.gz": {
			url: "https://github.com/rust-lang/rust-analyzer/releases/download/2026-09-28/rust-analyzer-x86_64-apple-darwin.gz",
			sha256:
				"d032c0eb75e4597cc8ffc35ea4cdbd9eecc8341936b6edac6749e679fc3f0682",
		},
		"rust-analyzer-x86_64-pc-windows-msvc.zip": {
			url: "https://github.com/rust-lang/rust-analyzer/releases/download/2026-09-28/rust-analyzer-x86_64-pc-windows-msvc.zip",
			sha256:
				"ad78fb368525404c6ac09c4bba33e90797902ce1f5a17db0925c695cae096ccc",
		},
		"rust-analyzer-x86_64-unknown-linux-gnu.gz": {
			url: "https://github.com/rust-lang/rust-analyzer/releases/download/2026-09-28/rust-analyzer-x86_64-unknown-linux-gnu.gz",
			sha256:
				"23f711d86b5f826e22886f01d7355dc01e0f4c1357dafa29710a95b903b48c85",
		},
		"clangd-linux-23.1.0.zip": {
			url: "https://github.com/clangd/clangd/releases/download/23.1.0/clangd-linux-23.1.0.zip",
			sha256:
				"e53b1a96196095faedb7642cf64964f7fb9ad4a0c1f00dd2c172a3d9dcbafdfd",
		},
		"clangd-mac-23.1.0.zip": {
			url: "https://github.com/clangd/clangd/releases/download/23.1.0/clangd-mac-23.1.0.zip",
			sha256:
				"1082e6638223b785ca2daf0939f13afcd0bb95c84ee9a4bbaff4745365159253",
		},
		"clangd-windows-23.1.0.zip": {
			url: "https://github.com/clangd/clangd/releases/download/23.1.0/clangd-windows-23.1.0.zip",
			sha256:
				"23412a240756a162e7b98a282f36aa2a23a88db5ce16a0cbc4fef7253768c810",
		},
		"OpenJDK21U-jdk_aarch64_linux_hotspot_21.0.12.1_1.tar.gz": {
			url: "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_aarch64_linux_hotspot_21.0.12.1_1.tar.gz",
			sha256:
				"23e37e026f12f3e706f18938ff611db3032d075b09d0879a25d06718c773e223",
		},
		"OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.12.1_1.tar.gz": {
			url: "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.12.1_1.tar.gz",
			sha256:
				"3623232f33a9c3baadf304480b2535f9a3cba8a58d42ecbb438ba267315d9998",
		},
		"OpenJDK21U-jdk_aarch64_windows_hotspot_21.0.12.1_1.zip": {
			url: "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_aarch64_windows_hotspot_21.0.12.1_1.zip",
			sha256:
				"ccf2e51f527d542a70ba5794a600d3aac04b4e967950e227834c7566cb1bec7b",
		},
		"OpenJDK21U-jdk_x64_linux_hotspot_21.0.12.1_1.tar.gz": {
			url: "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_x64_linux_hotspot_21.0.12.1_1.tar.gz",
			sha256:
				"ce79869e1307ed8ee1e2baa86a412b1eb5b75d10a01006d788a6f968bcfaee94",
		},
		"OpenJDK21U-jdk_x64_mac_hotspot_21.0.12.1_1.tar.gz": {
			url: "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_x64_mac_hotspot_21.0.12.1_1.tar.gz",
			sha256:
				"44db0f08196daf19a47f90d13388b0c943b67663cb537f998fe29e836fa842ce",
		},
		"OpenJDK21U-jdk_x64_windows_hotspot_21.0.12.1_1.zip": {
			url: "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_x64_windows_hotspot_21.0.12.1_1.zip",
			sha256:
				"f9d6e191ab098c0d416e7d588a24420a8621cd2f4720dab2459b8b7b2d2d8b4e",
		},
		"jdt-language-server-1.61.0-202609031315.tar.gz": {
			url: "https://download.eclipse.org/jdtls/milestones/1.61.0/jdt-language-server-1.61.0-202609031315.tar.gz",
			sha256:
				"338e7e73d61836651ba2453919a0d34fa763eb4e7c03342092309bffb8934c64",
		},
	},
} as const;

export function pinnedNativeAsset(name: string, upstreamSha?: string) {
	const pin = (
		nativeToolchainPins.assets as Record<
			string,
			{ url: string; sha256: string }
		>
	)[name];
	if (!pin)
		throw new Error(
			`No pinned native asset for ${name}; use a local server path.`,
		);
	if (upstreamSha && upstreamSha.toLowerCase() !== pin.sha256)
		throw new Error(
			`Upstream SHA256 changed for ${name}; download blocked by the committed pin.`,
		);
	return pin;
}
