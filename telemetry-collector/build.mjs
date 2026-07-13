// Build script for the telemetry-collector Lambda — issue #35.
//
// Bundles src/handler.ts (and everything it imports, including
// @aws-sdk/client-firehose — see package.json's comment on why that's a
// devDependency here) into a single self-contained dist/handler.mjs with
// esbuild, then zips it into dist/lambda.zip at the zip root so
// `aws lambda update-function-code --zip-file fileb://dist/lambda.zip`
// works with handler = "handler.handler" (see README.md).
//
// Run with: npm run build

import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'

const outfile = 'dist/handler.mjs'
const zipfile = 'dist/lambda.zip'

rmSync('dist', { recursive: true, force: true })
mkdirSync('dist', { recursive: true })

await build({
  entryPoints: ['src/handler.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile,
  sourcemap: false,
  logLevel: 'info',
})

if (!existsSync(outfile)) {
  throw new Error(`esbuild did not produce ${outfile}`)
}

// -j / --junk-paths: store handler.mjs at the zip root (no src/ or dist/
// prefix inside the archive), which is what Lambda's
// "handler.handler" (file.exportedFunction) setting expects.
execFileSync('zip', ['-j', zipfile, outfile], { stdio: 'inherit' })

console.log(`Built ${outfile} -> ${zipfile}`)
