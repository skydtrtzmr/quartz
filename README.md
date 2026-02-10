# Quartz部署说明（Windows环境）

1. 安装npm依赖包

在quartz项目根目录下，执行：

```
npm install
```

2. 配置server

在/server 文件夹中，复制config_example.json命名为config.json，按需进行配置。

重要参数说明：
- auth：查询参数与参数值配置，用于鉴权。
- quartz_dir：quartz生成的html静态文件的目录。
- command：
	- work_dir：quartz项目目录，实际被执行构建命令的地方。
	- agrs： `-d` 参数后面的路径，为md文件所在路径。

3. 运行服务。

执行`server/quartz-service.exe`来运行服务。

建议先启动==命令行==，在命令行窗口中执行该exe服务。因为直接双击点开的话，可能会因为鼠标点击触发交互模式导致窗口暂停活动。