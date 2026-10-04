/** @type {import('next').NextConfig} */
const config = {
  // A static site: every screen fetches its data from the API in the browser.
  output: "export",
  reactStrictMode: true,
  // The floating dev badge sits on top of the sidebar's account block.
  devIndicators: false,
};

export default config;
