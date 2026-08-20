/**
 * marked-terminal 的类型补丁。
 *
 * marked-terminal@6 未随包提供类型声明（无 .d.ts / types 字段），
 * DefinitelyTyped 的 @types/marked-terminal 只覆盖 v3 老 API，不适用。
 * 这里声明本应用用到的子集：
 * - default 导出 TerminalRenderer（构造时可传选项）
 * - 声明继承 marked.Renderer，使其可作 marked.parse 的 renderer 传入。
 *   运行时它并不真的 extends（靠 duck-typing 匹配方法），类型上如此声明
 *   即可满足 marked 的 renderer 入参要求。
 */
declare module 'marked-terminal' {
  import { Renderer } from 'marked';

  export interface TerminalRendererOptions {
    width?: number;
    showSectionPrefix?: boolean;
    reflowText?: boolean;
    tableOptions?: Record<string, unknown>;
  }

  export default class TerminalRenderer extends Renderer {
    constructor(options?: TerminalRendererOptions);
  }
}
