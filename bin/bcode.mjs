#!/usr/bin/env node
// 全局 bcode 指令入口：程序化注册 tsx 运行时后直接执行 TS 源码入口。
// 安装方式：npm i -g b-code（或从本目录 npm link / npm i -g .）
import { register } from "tsx/esm/api";

register();
await import("../src/index.ts");