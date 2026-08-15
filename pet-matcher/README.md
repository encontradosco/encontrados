# pet-matcher

Servicio de embeddings para fotos de mascotas (perros y gatos), separado del
resto de encontrados.co (que es Node). No compara ni guarda nada — solo
calcula el vector de una foto. La comparación y las reglas de privacidad
viven en el lado Node (`src/petmatch.js`).

## Instalar y correr local

    cd pet-matcher
    python3 -m venv venv
    source venv/bin/activate
    pip install -r requirements.txt
    python app.py

Queda escuchando en http://localhost:5001. Desde el lado Node, apunta
`PET_MATCH_API_URL=http://localhost:5001` en tu `.env`.

## Probar

    pytest -v

Las pruebas usan una función `embed_fn` de mentira inyectada en `create_app` —
no descargan el modelo real. La verificación contra el modelo real
(`AvitoTech/CLIP-ViT-base-for-animal-identification`, ~800 MB) se hace a mano,
una vez, no en cada corrida de la suite:

    python app.py &
    curl -s -F "image=@/ruta/a/una/foto/de/perro.jpg" http://localhost:5001/embed \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['embedding']), d['model'])"

Debe imprimir `512 AvitoTech/CLIP-ViT-base-for-animal-identification`.

## Contrato

`POST /embed`, multipart con el campo `image` →
`{ "embedding": [...], "model": "..." }`.

**Sin autenticación todavía.** No exponer este servicio a internet sin
agregar un secreto compartido primero (ver el documento de diseño en
`docs/superpowers/specs/`).

## Nota sobre la versión de `transformers`

`requirements.txt` pide `transformers==4.57.6`, no `4.44.0`. Con `4.44.0` la
carga del checkpoint real de este modelo falla con
`AttributeError: 'NoneType' object has no attribute 'get'`: el archivo
`model.safetensors` de este repo en HuggingFace no trae la metadata opcional
`{"format": "pt"}`, y `transformers==4.44.0` no maneja ese caso (asume que
`metadata()` nunca es `None`). Esto está arreglado en versiones más nuevas de
`transformers` (confirmado en `4.57.6`, con `torch==2.4.0` sin cambios). Esto
se descubrió y se verificó en la comprobación manual contra el modelo real
(abajo), no con las pruebas automatizadas — la suite de `pytest` nunca carga
el modelo real, así que no lo habría detectado.
