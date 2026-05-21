# Safe Routing for Flood-Aware Evacuation

A graph-based web application for computing safe evacuation routes under flood conditions in urban environments. Built on OpenStreetMap road network data and Copernicus flood extent data.

## Case study
Kremmen and Oranienburg, Brandenburg, Germany — January 2024 flood event.

## Features
- Interactive map with buildings classified by flood exposure (drowned, close to flood, at risk, safe)
- Flood-constrained routing using A* algorithm on a weighted graph
- Emergency routing to nearest safe building using KDTree spatial indexing
- Turn-by-turn navigation instructions
- Layer controls for flood polygons, buildings and flooded road segments

## Tech stack
| Layer | Technology |
|---|---|
| Backend | Python, Flask |
| Routing | NetworkX, A* algorithm |
| Spatial | GeoPandas, Shapely, SciPy |
| Frontend | HTML, CSS, JavaScript, Leaflet 1.7.1 |
| Map tiles | CartoDB Positron |

## Deployment

### Prerequisites
- Linux server
- Python 3.11+
- Nginx
- Dataset files (contact the authors)

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/LtVerdugo/safe-routing-flood-evacuation.git
cd safe-routing-flood-evacuation

# 2. Create virtual environment
python3 -m venv .venv
source .venv/bin/activate

# 3. Install dependencies
pip install -r requirements.txt

# 4. Add dataset files
# Place the Brandenburg dataset folder under:
# datasets/brandenburg/
#   ├── G.pkl
#   ├── buildings.geojson
#   └── flood.geojson

# 5. Start with Gunicorn
gunicorn -w 2 -b 0.0.0.0:5000 app:app
```

### Nginx configuration

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Dataset files
The dataset files are not included in this repository due to their size (~476MB).
Download the Brandenburg dataset from Google Drive and place it under `datasets/brandenburg/`:

[Download dataset →](https://drive.google.com/drive/folders/10sW6YThdI_08FfQj6Mug9D2-thbJdlkx?usp=sharing)

Expected structure:
```
datasets/
└── brandenburg/
    ├── G.pkl
    ├── buildings.geojson
    └── flood.geojson
```

## Data sources
- Flood extent: Copernicus Emergency Management Service — EMSN068 Brandenburg
- Buildings and road network: OpenStreetMap via Geofabrik

## Related project
[Flood Vulnerability Assessment and Evacuation Routing — Wilhelmsburg, Hamburg](https://experience.arcgis.com/experience/15a21125075b4af38a40f5298a32d20a)

## License
Academic use only. HafenCity Universität Hamburg.
