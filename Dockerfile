# 多阶段构建：阶段1 构建前端，阶段2 运行后端并托管前端静态产物

# ---- 阶段1：构建前端 ----
FROM node:20-alpine AS frontend
WORKDIR /fe
COPY frontend/package.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# ---- 阶段2：后端运行 ----
FROM python:3.11-slim
WORKDIR /app
COPY backend/ ./
RUN pip install . --no-cache-dir

# 托管前端构建产物
COPY --from=frontend /fe/dist /app/frontend_dist
ENV STATIC_DIR=/app/frontend_dist
ENV DB_PATH=/app/data/travelplanner.db

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
