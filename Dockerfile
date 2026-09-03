FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 3000

CMD ["gunicorn", "--workers", "1", "--threads", "8", "--bind", "0.0.0.0:3000", "app.server:app"]
