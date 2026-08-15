import io
from PIL import Image
from app import create_app


def fake_embed(image):
    return [0.1, 0.2, 0.3]


def make_test_client():
    app = create_app(embed_fn=fake_embed)
    app.testing = True
    return app.test_client()


def make_test_image_bytes():
    img = Image.new('RGB', (10, 10), color=(255, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format='JPEG')
    buf.seek(0)
    return buf


def test_embed_returns_the_vector_and_model_name():
    client = make_test_client()
    resp = client.post(
        '/embed',
        data={'image': (make_test_image_bytes(), 'foto.jpg')},
        content_type='multipart/form-data'
    )
    assert resp.status_code == 200
    body = resp.get_json()
    assert body['embedding'] == [0.1, 0.2, 0.3]
    assert 'model' in body


def test_embed_without_image_is_a_400():
    client = make_test_client()
    resp = client.post('/embed', data={}, content_type='multipart/form-data')
    assert resp.status_code == 400


def test_embed_with_unreadable_bytes_is_a_400():
    client = make_test_client()
    resp = client.post(
        '/embed',
        data={'image': (io.BytesIO(b'no es una imagen'), 'foto.jpg')},
        content_type='multipart/form-data'
    )
    assert resp.status_code == 400
