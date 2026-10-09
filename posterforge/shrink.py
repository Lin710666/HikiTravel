#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""shrink.py：把一张图缩到指定长边，产出「给视觉模型看的那一份」。

为什么需要这个：
    Ollama 把图片编码成图像 token，Qwen2.5-VL 每 1 个 token 覆盖 28x28 像素。
    用户上传的素材常是手机截图 / 相机原图，实测一张 2642x1715 的 PNG
    约 5779 个图像 token，加上版式说明的提示词，合计 4338 个有效 token，
    超过 qwen2.5vl:3b 默认的 4096 上下文窗口，请求被直接拒掉：

        {"code":400,"message":"request (4338 tokens) exceeds available
         context size (4096 tokens)","type":"exceed_context_size_error"}

    缩到长边 896 之后约 1024 个 token，既进得去、也快得多，
    而"这张图该怎么排"这个判断本来就不需要看原始分辨率。

它**只产出给模型看的那一份**。渲染海报用的仍是原图，不受影响，
所以不要在用户上传时就缩图，那会把成品画质一起降下去。

用法:
    python shrink.py <输入路径> <长边上限> <输出路径>
输出:
    成功时向 stdout 打印实际产出的 `宽x高`，失败时向 stderr 打印原因并返回非 0。
"""

import os
import sys


def main(argv):
    if len(argv) < 4:
        print("用法: shrink.py <输入路径> <长边上限> <输出路径>", file=sys.stderr)
        return 2

    src, limit_raw, dst = argv[1], argv[2], argv[3]
    try:
        limit = int(limit_raw)
    except ValueError:
        print("长边上限必须是整数：%r" % (limit_raw,), file=sys.stderr)
        return 2
    if limit <= 0:
        print("长边上限必须为正数：%d" % limit, file=sys.stderr)
        return 2
    if not os.path.exists(src):
        print("输入图不存在：%s" % src, file=sys.stderr)
        return 3

    try:
        from PIL import Image
    except ImportError:
        print("缺少 Pillow，请先 pip install pillow", file=sys.stderr)
        return 4

    try:
        with Image.open(src) as im:
            w, h = im.size
            longest = max(w, h)
            if longest > limit:
                scale = float(limit) / float(longest)
                nw = max(1, int(round(w * scale)))
                nh = max(1, int(round(h * scale)))
                # LANCZOS 是缩图质量最好的一档，代价只有几十毫秒
                im = im.convert("RGB").resize((nw, nh), Image.LANCZOS)
            else:
                nw, nh = w, h
                im = im.convert("RGB")

            parent = os.path.dirname(dst)
            if parent:
                os.makedirs(parent, exist_ok=True)
            # 存 JPEG 而不是 PNG：同样的画面内容，文件小一个数量级，
            # base64 之后进 HTTP 请求体的体积也随之小一个数量级。
            im.save(dst, "JPEG", quality=86, optimize=True)
    except Exception as exc:  # 图损坏、格式不支持等，都如实报出来
        print("缩图失败：%s" % exc, file=sys.stderr)
        return 5

    print("%dx%d" % (nw, nh))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
