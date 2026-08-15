"""Calcula el embedding de una foto de perro o gato.

Modelo: AvitoTech/CLIP-ViT-base-for-animal-identification (Apache 2.0),
afinado para distinguir individuos de perros y gatos — no personas, y no
"¿hay un animal en la foto?": eso lo asume el formulario que pide la especie,
no este modelo.
"""
from transformers import CLIPModel, CLIPImageProcessor
import torch

MODEL_NAME = "AvitoTech/CLIP-ViT-base-for-animal-identification"

_model = None
_processor = None


def _load():
    global _model, _processor
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
