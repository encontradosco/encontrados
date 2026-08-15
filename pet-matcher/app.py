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

from model import embed_image, MODEL_NAME


def create_app(embed_fn=None):
    app = Flask(__name__)
    embed = embed_fn or embed_image

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
