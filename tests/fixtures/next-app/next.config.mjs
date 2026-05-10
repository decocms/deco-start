/** @type {import('next').NextConfig} */
const nextConfig = {
  // Intentionally NOT using transpilePackages — we want to prove
  // @decocms/start is consumable without it.
  experimental: {
    typedRoutes: true,
  },
};

export default nextConfig;
