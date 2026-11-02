---
kind: upgrade-guide
description: "持久化的 Client store 需要必填的 parse 函数，defineStore 的 persist 由键字符串改为选项对象。"
---

# 持久化的 Client store 需要已存值解析函数

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-client-store` 过去直接装入从 `localStorage` 读出的值，不做检查。其他 Client 版本、其他标签页或手工编辑写入的值，会带着原有类型到达读取方。现在持久化接收 [`PersistOptions<T>`](../../../../packages/client/store/src/contract.ts)：一个 `name` 和必填的 `parse(value: unknown): T | undefined`。store 只装入 `parse` 返回的值；`parse` 返回 undefined 时，store 保留初始状态，并在控制台记录该键。已存文本保留到下一次状态变更将其覆盖。

这会影响调用 `createSnapshotStore(init, { persist: { name } })` 或 `defineStore({ init, persist: '<key>', actions })` 的 Client 插件。不做持久化的代码不受影响，已存 JSON 的格式与键也不变。

## 迁移

1. 为每个持久化的状态类型编写解析函数。它接收任意 JSON 值，因此要检查每个字段并返回新值，或返回 undefined 以保留初始状态。

2. 在每个 `createSnapshotStore` 调用中加入解析函数：

   ```ts
   import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

   const parseWidth = (value: unknown): number | undefined =>
     typeof value === 'number' && value > 0 ? value : undefined

   createSnapshotStore(280, { persist: { name: 'my-plugin.width', parse: parseWidth } })
   ```

3. 把每个 `defineStore` 的键字符串换成选项对象。session 作用域的实例仍存储在 `<name>.<scopeKey>` 下：

   ```ts
   import { defineStore } from '@deepseek-ai/dsh-client-store'

   interface Panel { open: boolean }

   const parsePanel = (value: unknown): Panel | undefined =>
     typeof value === 'object' && value !== null && 'open' in value && typeof value.open === 'boolean'
       ? { open: value.open }
       : undefined

   function createPanelStore() {
     return defineStore({
       init: (): Panel => ({ open: false }),
       persist: { name: 'my-plugin.panel', parse: parsePanel },
       actions: { toggle: (draft) => { draft.open = !draft.open } },
     })
   }
   ```

4. 运行 Client 类型检查。缺少 `parse`、`persist` 仍为字符串、或解析函数的参数类型比 `unknown` 更窄，都会产生编译错误。然后在该键下存入 `null` 等无效值，重新加载，确认 store 从初始状态开始。
