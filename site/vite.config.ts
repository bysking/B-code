import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * 两种构建产物:
 *   bun run build         → dist/       常规多文件(便于部署到静态托管)
 *   bun run build:single  → single/     单个 HTML,内联全部 JS/CSS,双击即开
 *
 * 用环境变量而不是两个 config 文件,是为了让两边共用同一份插件与别名配置。
 */
const single = process.env.BUILD_SINGLE === '1';

export default defineConfig({
  plugins: [react(), ...(single ? [viteSingleFile()] : [])],
  // 单文件用相对路径没意义,但保留 './' 对两种产物都安全
  base: './',
  server: {
    port: 5199,
    // 端口被占用时直接报错,而不是悄悄换到 5200
    strictPort: true,
  },
  preview: {
    port: 5199,
    strictPort: true,
  },
  build: {
    outDir: single ? 'single' : 'dist',
    sourcemap: false,
    // 单文件模式必须关闭代码分割,否则会产出多个 chunk
    cssCodeSplit: !single,
    assetsInlineLimit: single ? 100_000_000 : 4096,
    rollupOptions: single
      ? { output: { inlineDynamicImports: true, manualChunks: undefined } }
      : {},
  },
});
