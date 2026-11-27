# Mapaprov · Fiber 3D

Projetista de redes FTTH em **mapa 3D interativo** da cidade de **Cubatão/SP**, integrado aos
projetos **KML/KMZ do IXC Fiber Docs**. Endereço de produção: **https://mapa.noc.updown.com.br**

Site 100% estático (HTML + JavaScript), sem banco de dados e sem build: basta servir a pasta `public/`.

## O que tem

**Mapa da cidade em 3D**
- Ruas, quadras, nomes e **prédios 3D** do OpenStreetMap (OpenFreeMap)
- **Imagem de satélite** (Esri World Imagery)
- **Relevo 3D** (Serra do Mar) com exagero ajustável
- **Limite municipal oficial** do IBGE (código 3513504)
- **Bairros** de Cubatão e **postes** mapeados no OpenStreetMap (importa os postes da área visível)
- Busca de endereço (Nominatim) e de elementos do projeto
- Atalhos para **Google Maps, Street View e Google Earth** no ponto selecionado
- **Plantas**: sobreponha uma imagem (PNG/JPG) e ajuste os 4 cantos às ruas; camadas de referência KML/KMZ/GeoJSON

**Modo realista (Google) e fotos de rua**
- Botão **Realista**: prédios, postes, árvores e relevo **reais em 3D** (Google Photorealistic 3D Tiles), com a rede desenhada por cima
- Botão **Street View** (tecla `S`): clique em qualquer rua ou elemento e a foto real abre num painel ao lado do mapa, olhando na mesma direção da câmera
- **Postes reais (Mapillary)**: importa os postes detectados automaticamente nas fotos de rua da área visível

**Projeto de rede**
- Elementos: **POP/OLT, CEO (caixa de emenda), CTO (caixa de atendimento), poste, reserva técnica, cliente/ONU** e marcador
- **Lançamento de cabos** de poste em poste (backbone, distribuição e drop; 1 a 288 FO; aéreo ou subterrâneo), com encaixe automático em postes/caixas e criação de postes nos vértices
- Cabos aéreos em 3D na altura do poste e com **catenária**; caixas instaladas nos postes
- **Drop**: da CTO até o cliente (cria o cliente), com ocupação de portas da CTO
- **Diagrama de fusões** por caixa: fibras com **código de cores ABNT** (tubos loose), splitters 1x2…1x64, fusão sequencial automática
- **Orçamento óptico estimado** (POP → caixa) e lista de sinal das CTOs
- **Lista de materiais** (caixas, splitters, metragem de cabo com reservas e catenária, ancoragens/suspensões, fusões) com exportação CSV
- Desfazer/refazer, salvamento automático no navegador, arquivo de projeto `.json`

**Integração com o IXC Fiber Docs**
- **Importar**: no IXC, abra o projeto em *Fiber Docs* e exporte em KML/KMZ; no Fiber 3D use *Projeto → Importar KML/KMZ*.
  Os itens são classificados pelo nome/pasta (CTO, CEO, POP/OLT, poste, reserva, cliente, drop, backbone, “12FO”…),
  campos do ExtendedData com o mesmo nome (ex.: `portas`, `modelo`) são aproveitados e os vértices dos cabos a até 3 m
  de um elemento são ligados a ele.
- **Exportar**: KMZ/KML organizado em pastas por tipo (abre no Google Earth e pode ser importado no Fiber Docs) e GeoJSON.

> A leitura é feita a partir do arquivo exportado: o Fiber Docs fica atrás do login do IXC e não foi acessado
> diretamente. Se algum tipo vier classificado errado, ajuste o nome das pastas no IXC ou troque o tipo no painel
> de propriedades.

## Chaves de API (modo realista)

O mapa básico funciona sem chave. Para o modo realista:

1. **Google** — no [Google Cloud Console](https://console.cloud.google.com/google/maps-apis), num projeto com faturamento ativo,
   ative **Map Tiles API** (prédios 3D) e **Maps Embed API** (Street View) e crie uma chave de API.
   Em *Restrições de aplicativo* escolha *Sites* e informe `https://mapa.noc.updown.com.br/*`;
   em *Restrições de API* deixe só as duas APIs acima.
   - Street View pelo Maps Embed API não é cobrado.
   - O 3D é cobrado por sessão (cada abertura do modo realista conta uma; a sessão dura algumas horas), com uma
     cota mensal gratuita — confira os valores atuais na página de preços do Google Maps Platform.
2. **Mapillary** (opcional) — crie um app em https://www.mapillary.com/dashboard/developers e copie o *Client Token*.

Para a equipe toda usar as mesmas chaves, crie no servidor o arquivo `public/config.json` (ele fica fora do git):
```bash
sudo cp /opt/mapaprov/deploy/config.example.json /opt/mapaprov/public/config.json && sudo nano /opt/mapaprov/public/config.json
```
Também é possível digitar as chaves em *Camadas → Chaves de API* (ficam só naquele navegador).

> A qualidade e a data das imagens dependem da cobertura do Google e do Mapillary em cada rua de Cubatão.
> No modo realista o mapa OSM, o satélite Esri e o relevo próprio ficam ocultos, porque os termos do Google não permitem
> misturar o conteúdo deles com outros mapas base. Se os cabos aparecerem enterrados ou flutuando, ajuste
> *Camadas → Altura da rede sobre o modelo do Google*.

## Uso

| Tecla | Ação |
|---|---|
| `V` | Selecionar / mover (arraste o elemento selecionado) |
| `K` | Lançar cabo — clique de poste em poste; duplo clique ou `Enter` conclui; botão direito desfaz ponto |
| `D` | Drop para cliente |
| `P` `E` `C` `O` `R` `L` `M` | POP, CEO, CTO, Poste, Reserva, Cliente, Marcador |
| `N` | Medir distância |
| `S` | Street View no ponto clicado |
| `Del` | Excluir seleção |
| `Ctrl+Z` / `Ctrl+Y` | Desfazer / refazer |
| Botão direito + arrastar | Girar e inclinar o 3D |

Cabo selecionado: arraste os pontos brancos; `Shift+clique` no cabo insere ponto; `Alt+clique` em um ponto remove.

O projeto fica salvo **no navegador de quem está usando**. Para guardar ou compartilhar, use *Salvar (.json)* ou exporte em KMZ.

## Instalação no servidor (190.111.110.13)

1. **DNS**: crie o registro `A` de `mapa.noc.updown.com.br` apontando para `190.111.110.13`.

2. **Código**:
   ```bash
   sudo git clone https://github.com/FelpLuis/Mapaprov.git /opt/mapaprov
   ```

3. **Caddy** (o mesmo que já atende `tv.updown.com.br`): acrescente o conteúdo de
   `deploy/Caddyfile.mapa.noc.updown.com.br` ao `/etc/caddy/Caddyfile` e recarregue:
   ```bash
   sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
   ```
   O Caddy emite o certificado HTTPS sozinho (portas 80 e 443 precisam estar abertas).
   Se o servidor usar Nginx, use `deploy/nginx-mapa.noc.updown.com.br.conf`.

4. **Após atualizar para a versão com modo realista**, recopie a configuração (o CSP mudou) e recarregue:
   ```bash
   sudo cp /opt/mapaprov/deploy/nginx-mapa.noc.updown.com.br.conf /etc/nginx/sites-available/mapa.noc.updown.com.br && sudo nginx -t && sudo systemctl reload nginx
   ```
   Se o HTTPS já estava ativo, reaplique o certificado existente no arquivo novo:
   ```bash
   sudo certbot --nginx -d mapa.noc.updown.com.br --redirect --reinstall
   ```

5. **Atualizar** depois:
   ```bash
   cd /opt/mapaprov && sudo git pull
   ```

O cabeçalho `Content-Security-Policy` dos arquivos de deploy libera apenas os serviços de mapa usados.
Se trocar alguma fonte em `public/js/config.js`, atualize o CSP também.

## Teste local

```bash
python3 -m http.server 8080 -d public
```
e abra http://localhost:8080

## Fontes de dados e licenças

- Mapa base: © OpenStreetMap contributors, via [OpenFreeMap](https://openfreemap.org)
- Satélite: Esri World Imagery (Esri, Maxar, Earthstar Geographics)
- Relevo: Mapzen/AWS Terrain Tiles
- Limite municipal: IBGE — Malha Municipal
- Modo realista: Google Photorealistic 3D Tiles e Street View (© Google, exige chave); Mapillary (CC BY-SA)
- Bibliotecas incluídas em `public/vendor/`: MapLibre GL JS 5.6 (BSD-3), deck.gl 9.1 (MIT), decodificador Draco (Apache-2.0), JSZip 3.10 (MIT/GPLv3)
