#!/bin/sh
# 三个 bundle 的构建脚本。
#
# 用**脚本自身所在目录**固定工作目录，而不是写死绝对路径 ——
# 写死的话别人 clone 下来直接就不能用，而且会把作者的本机目录带进仓库。
# （某些调用方会丢掉 cd 前缀，所以这里必须显式 cd。）
cd "$(dirname "$0")" || exit 1
node_modules/.bin/vite build --config vite.main.config.mts || exit 1
node_modules/.bin/vite build --config vite.preload.config.mts || exit 1
node_modules/.bin/vite build --config vite.renderer.config.mts || exit 1
echo BUILD_OK
