import esbuild from 'esbuild'

function createBuildSettings(options, isDev = false) {
  return {
    entryPoints: ['src/index.js'],
    platform: 'neutral',
    target: ['esnext'],
    format: 'esm',
    bundle: true,
    sourcemap: true,
    treeShaking: true,
    define: {
      "process.env.NODE_ENV": isDev ? '"production"' : '"development"',
    },
    ...options
  };
}

await esbuild.build(createBuildSettings({
  minify: true,
  outfile: 'dist/index.min.js',
}));

await esbuild.build(createBuildSettings({
  outdir: 'dist',
}));
