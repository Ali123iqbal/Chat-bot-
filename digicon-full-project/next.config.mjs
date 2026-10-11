import path from "node:path";

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  webpack(config) {
    config.resolve.alias["@"] = path.join(import.meta.dirname, "src");
    return config;
  },
};
