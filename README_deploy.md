# Deployment Guide — Flood Evacuation Routing

## Steps

### 1. Copy the project
Transfer the project folder to the server.

### 2. Create and activate a virtual environment
```bash
python -m venv .venv
source .venv/bin/activate
```

### 3. Install dependencies
```bash
pip install -r requirements.txt
```

### 4. Add dataset files
Place the Brandenburg dataset under `datasets/brandenburg/` containing `G.pkl`, `buildings.geojson` and `flood.geojson`.

### 5. Start the server
```bash
gunicorn --workers 1 --bind 0.0.0.0:5000 --timeout 120 wsgi:app
```

### 6. Configure the public URL

If nginx strips the prefix before forwarding to Gunicorn:

```nginx
location /demos/flood-evacuation/ {
    proxy_pass http://127.0.0.1:5000/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

If nginx forwards the prefix unchanged, start Gunicorn with:

```bash
PUBLIC_BASE_PATH=/demos/flood-evacuation \
gunicorn --workers 1 --bind 0.0.0.0:5000 --timeout 120 wsgi:app
```

### 7. Verify
```bash
curl https://www.cml.hcu-hamburg.de/demos/flood-evacuation/healthz
```
