---
kind: upgrade-guide
description: "Persisted Client stores take a required parse function, and defineStore persist takes an options object instead of a key string."
---

# Persisted Client stores require a stored-value parser

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-client-store` installed a value read from `localStorage` without checking it. A value written by another Client version, another tab, or manual editing reached readers with whatever type it had. Persistence now takes [`PersistOptions<T>`](../../../../packages/client/store/src/contract.ts): a `name` and a required `parse(value: unknown): T | undefined`. The store installs only what `parse` returns; when `parse` returns undefined, the store keeps the initial state and logs the key to the console. The stored text stays until the next state change overwrites it.

This affects Client plugins that call `createSnapshotStore(init, { persist: { name } })` or `defineStore({ init, persist: '<key>', actions })`. Code that does not persist is unchanged, and the stored JSON format and keys are unchanged.

## Migration

1. Write a parser for each persisted state type. It receives any JSON value, so check every field and return a new value, or undefined to keep the initial state.

2. Add the parser to each `createSnapshotStore` call:

   ```ts
   import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

   const parseWidth = (value: unknown): number | undefined =>
     typeof value === 'number' && value > 0 ? value : undefined

   createSnapshotStore(280, { persist: { name: 'my-plugin.width', parse: parseWidth } })
   ```

3. Replace each `defineStore` key string with an options object. Session-scope instances still store under `<name>.<scopeKey>`:

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

4. Run the Client typecheck. A missing `parse`, a `persist` string, or a parser whose parameter is narrower than `unknown` is a compile error. Then store an invalid value such as `null` under the key, reload, and confirm the store starts from its initial state.
