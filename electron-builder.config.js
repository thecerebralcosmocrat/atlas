module.exports = {
  appId: "com.atlas.app",
  productName: "Atlas",
  directories: { output: "dist/installer" },
  files: ["dist/renderer/**", "electron/**", "node_modules/**", "package.json"],
  win: { target: "nsis" },
};
