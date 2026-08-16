"""Servicio de embeddings para mascotas. Un único endpoint: recibe una foto,
devuelve un vector. No compara nada y no guarda nada — esa lógica y las
reglas de privacidad viven en el lado Node (src/petmatch.js), igual que hoy
Rekognition solo compara y el resto vive en facematch.js.

Sin autenticación todavía — ver docs/superpowers/specs/2026-08-15-mascotas-
perdidas-design.md, "Pendiente antes de producción". No exponer a internet
sin agregarla primero.
"""
import io
from flask import Flask, request, jsonify
from PIL import Image

from model import embed_image, MODEL_NAME, _load


def create_app(embed_fn=None):
    app = Flask(__name__)
    if embed_fn is None:
        # Cargar el modelo AL ARRANCAR, no en el primer /embed que llegue —
        # así el primer reporte real no paga el costo de la descarga/carga
        # del modelo, tal como pide el diseño. El camino de pruebas
        # (embed_fn inyectado) nunca debe tocar el modelo real, así que este
        # `_load()` eager solo corre cuando NO hay una función de mentira.
        _load()
        embed = embed_image
    else:
        embed = embed_fn

    @app.route('/embed', methods=['POST'])
    def embed_route():
        if 'image' not in request.files:
            return jsonify({'error': 'falta el archivo image'}), 400
        raw = request.files['image'].read()
        try:
            image = Image.open(io.BytesIO(raw)).convert('RGB')
        except Exception:
            return jsonify({'error': 'no se pudo leer la imagen'}), 400
        vector = embed(image)
        return jsonify({'embedding': vector, 'model': MODEL_NAME})

    return app


if __name__ == '__main__':
    create_app().run(host='0.0.0.0', port=5001)
