# Imagen de desarrollo local. Node 22 iguala a CI: un fallo de un módulo
# nativo no depende de la versión de Node del equipo.
FROM node:22-bookworm-slim

# better-sqlite3 y sharp traen binarios precompilados para linux. Estas
# herramientas solo actúan si un binario falta y toca compilarlo.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiamos primero los manifiestos: la capa de dependencias se cachea y no
# se reinstala en cada cambio de código.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 3000

# node --watch reinicia al cambiar un archivo. En docker-compose el código
# llega por un bind mount, así que editar en el equipo reinicia adentro.
CMD ["npm", "run", "dev"]
