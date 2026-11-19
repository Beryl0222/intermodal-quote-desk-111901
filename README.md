# 联运报价邮件中的组合条件与可售方案

mail 的 replyTo 表示对某封邮件的回复。network 是服务路段及限界。requests 给出箱高和最大可接受无温控分钟数。allotments 是已收到的供应商包舱回执，编号在该供应商内唯一。transfers 用进出段编号表示可交接的路段组合。minutes 是换装耗时，conditioned 表示换装期间有温控。

资料保存在 `data/inputs.json`，采用 UTF-8 JSON。记录、人员、地点和业务编号均为合成内容。

运行环境为 Node.js 22.23.4，资料工具和测试使用 Node.js 标准库。

```sh
npm run inspect:data
npm test
```

`inspect:data` 读取资料并列出记录数。测试核对该批资料的字段和引用完整性。
