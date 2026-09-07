import { defineConfig } from 'tsdown'

const isExternal = (specifier: string): boolean =>
  specifier === 'react'
  || specifier === 'react/jsx-runtime'
  || specifier === 'react-dom'
  || specifier === '@deepseek-ai/cordis'
  || specifier.startsWith('@deepseek-ai/')

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    clean: false,
    dts: false,
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    fixedExtension: false,
    clean: false,
    dts: false,
    deps: { neverBundle: isExternal },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: "window.__ModuleLoader__.load({ id: '@zhaolianghz/dsh-turnscope', factory: (require) => {",
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
