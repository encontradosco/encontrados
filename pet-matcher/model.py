"""Calcula el embedding de una foto de perro o gato.

Modelo: AvitoTech/CLIP-ViT-base-for-animal-identification (Apache 2.0),
afinado para distinguir individuos de perros y gatos — no personas, y no
"¿hay un animal en la foto?": eso lo asume el formulario que pide la especie,
no este modelo.
"""
from transformers import CLIPModel, CLIPImageProcessor
import torch
import threading

MODEL_NAME = "AvitoTech/CLIP-ViT-base-for-animal-identification"

_model = None
_processor = None
_load_lock = threading.Lock()


def _load():
    global _model, _processor
    # Flask corre threaded por omisión: sin el lock, dos primeras peticiones
    # a la vez podrían pasar juntas el "if _model is None" de afuera y cada
    # una construir su propia copia del modelo. Doble chequeo — el segundo,
    # ya con el lock tomado — para no pagar el costo del lock en cada
    # petición una vez que el modelo ya está cargado.
    if _model is None:
        with _load_lock:
            if _model is None:
                _processor = CLIPImageProcessor.from_pretrained(MODEL_NAME)
                _model = CLIPModel.from_pretrained(MODEL_NAME)
                _model.eval()
    return _model, _processor


def embed_image(pil_image):
    model, processor = _load()
    inputs = processor(images=pil_image, return_tensors="pt")
    with torch.no_grad():
        features = model.get_image_features(**inputs)
    return features[0].tolist()
