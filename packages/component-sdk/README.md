# @onefish/component-sdk

OneFish Component Contract v1 的契约包。

它只包含：

- manifest 校验；
- inbound / outbound 信封校验；
- API 版本和 core 版本检查。

它不包含 OneFish Core 实现，也不 import DSH。

## 组件作者怎么用

```js
import { validateManifest, createInbound } from '@onefish/component-sdk';

const manifest = validateManifest({
  manifestVersion: 1,
  id: 'echo',
  name: 'Echo',
  version: '0.1.0',
  apiVersion: 1,
  core: '^0.1.0',
  capabilities: {
    channel: { inbound: true, outbound: 'auto' },
    tools: false,
    jobs: false,
    context: true,
  },
  state: true,
});
```

组件实际运行由 `ctx.onefishCore` 提供 scoped handle，不要 import `onefish-core` 内部文件。
