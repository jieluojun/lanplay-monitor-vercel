# syntax=docker/dockerfile:1
# 完整功能镜像：UDP 扫描 / 后台线程 / 本地读写 / 远程自更新全部可用。
# 与 Vercel 版共用同一份 main.py + script.js（未做任何修改）。

FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PORT=11451

WORKDIR /app

# 只复制运行所需文件
COPY main.py script.js ./
COPY servers.json chinese_db.json ./

EXPOSE 11451

CMD ["python", "-u", "main.py"]
