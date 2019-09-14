#!/bin/bash

docker build mm25_game_engine -t pranaygp/mm
docker push pranaygp/mm
docker build . -t gcr.io/mechmania2017/runner:latest
docker push gcr.io/mechmania2017/runner:latest
kubectl apply -f app.yaml
kubectl delete pods -l app=runner