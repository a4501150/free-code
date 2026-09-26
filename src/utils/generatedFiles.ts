/**
 * File patterns that should be excluded from attribution.
 * Based on GitHub Linguist vendored patterns and common generated file patterns.
 */

// Exact file name matches (case-insensitive)
const EXCLUDED_FILENAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
  'composer.lock',
  'gemfile.lock',
  'cargo.lock',
  'poetry.lock',
  'pipfile.lock',
  'shrinkwrap.json',
  'npm-shrinkwrap.json',
])

// File extension patterns (case-insensitive)
const EXCLUDED_EXTENSIONS = new Set([
  '.lock',
  '.min.js',
  '.min.css',
  '.min.html',
  '.bundle.js',
  '.bundle.css',
  '.generated.ts',
  '.generated.js',
  '.d.ts', // TypeScript declaration files
])

// Directory patterns that indicate generated/vendored content
const EXCLUDED_DIRECTORIES = [
  '/dist/',
  '/build/',
  '/out/',
  '/output/',
  '/node_modules/',
  '/vendor/',
  '/vendored/',
  '/third_party/',
  '/third-party/',
  '/external/',
  '/.next/',
  '/.nuxt/',
  '/.svelte-kit/',
  '/coverage/',
  '/__pycache__/',
  '/.tox/',
  '/venv/',
  '/.venv/',
  '/target/release/',
  '/target/debug/',
]

// Filename patterns using regex for more complex matching
const EXCLUDED_FILENAME_PATTERNS = [
  /^.*\.min\.[a-z]+$/i, // *.min.*
  /^.*-min\.[a-z]+$/i, // *-min.*
  /^.*\.bundle\.[a-z]+$/i, // *.bundle.*
  /^.*\.generated\.[a-z]+$/i, // *.generated.*
  /^.*\.gen\.[a-z]+$/i, // *.gen.*
  /^.*\.auto\.[a-z]+$/i, // *.auto.*
  /^.*_generated\.[a-z]+$/i, // *_generated.*
  /^.*_gen\.[a-z]+$/i, // *_gen.*
  /^.*\.pb\.(go|js|ts|py|rb)$/i, // Protocol buffer generated files
  /^.*_pb2?\.py$/i, // Python protobuf files
  /^.*\.pb\.h$/i, // C++ protobuf headers
  /^.*\.grpc\.[a-z]+$/i, // gRPC generated files
  /^.*\.swagger\.[a-z]+$/i, // Swagger generated files
  /^.*\.openapi\.[a-z]+$/i, // OpenAPI generated files
]
