import { useMemo } from 'react';
import { useRenderer } from '@opentui/react';
import { SyntaxStyle } from '@opentui/core';

/**
 * Markdown 渲染（OpenTUI 原生 `<markdown>`）。
 *
 * ## 为什么换掉 marked + marked-terminal
 *
 * 旧实现把 markdown 解析成 **ANSI 转义字符串**再塞给 `<text>`——那是 ink 时代的
 * 做法（ink 只能渲染字符串）。代价是多一层解析管线、拿不到原生能力
 * （语法高亮、可选中文本、链接），样式也不受主题控制。
 *
 * ## syntaxStyle 的归属（踩过的坑）
 *
 * `<markdown>` 要求传 `SyntaxStyle`，而它绑定**创建时那个渲染器**的原生资源。
 * 不能在模块级缓存一份共享——测试里每次渲染都新建渲染器，第一个渲染器销毁后
 * 共享的 style 就变成 `Resource Context is destroyed`，后续渲染全部报错。
 *
 * 正确做法：**按渲染器实例缓存**（WeakMap），渲染器销毁后自动失效。
 */
const styleCache = new WeakMap<object, SyntaxStyle>();

export function MarkdownText({ content }: { content: string }) {
  const renderer = useRenderer();

  const style = useMemo(() => {
    const key = renderer as unknown as object;
    let cached = styleCache.get(key);
    if (!cached) {
      cached = SyntaxStyle.create(
        (renderer as unknown as { nativeScene: never }).nativeScene,
      );
      styleCache.set(key, cached);
    }
    return cached;
  }, [renderer]);

  if (!content.trim()) return null;
  return <markdown content={content} syntaxStyle={style} />;
}
