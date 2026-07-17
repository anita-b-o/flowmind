import type { Config } from "jest";

const config: Config = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: ".",
  testRegex: ".*\\.spec\\.ts$",
  transform: {
    "^.+\\.ts$": "ts-jest"
  },
  testPathIgnorePatterns: ["/node_modules/", "/dist/", "/build/"],
  modulePathIgnorePatterns: ["<rootDir>/dist", "<rootDir>/build"],
  testEnvironment: "node"
};

export default config;
