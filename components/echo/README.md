# onefish-component-echo

Component Contract v1 的假组件。

它只验证：

- manifest 校验；
- `onefishCore.components.register`；
- `start / stop / health`；
- inbound submit；
- outbound auto 订阅。

不接 QQ / B站 / 桌宠，不发送任何真实消息。

## 测试

```powershell
cd $env:USERPROFILE\.dsh\OneFish\components\echo
npm install
npm test
```

## 说明

这是契约测试组件，不要安装到 live DSH；真实组件从 B站/桌宠开始接入。
