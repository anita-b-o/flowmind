from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_classify_requires_service_key() -> None:
    response = client.post("/classify", json={"text": "urgent lead"})
    assert response.status_code == 401


def test_classify_with_fake_provider() -> None:
    response = client.post(
        "/classify",
        headers={"x-service-api-key": "dev-ai-service-key"},
        json={"text": "urgent lead"},
    )
    assert response.status_code == 200
    assert response.json()["label"] == "high"
