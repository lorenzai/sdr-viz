import time
import json
import uuid
import multiprocessing

import web

from nupic.research.spatial_pooler import SpatialPooler as SP

from htmschoolviz import SpWrapper
from htmschoolviz.utils import saveStateToRedis, compress, decompress


global spWrappers
spWrappers = {}

SP_DETAILS = [
  "permanences",
  "connectedSynapses",
  "potentialPools",
  "activeDutyCycles",
  "overlapDutyCycles",
]

urls = (
  "/", "Index",
  "/client/(.+)", "Client",
  "/_sp/", "SPInterface",
  "/_sp/(.+)/history/(.+)", "SPHistory",
)
app = web.application(urls, globals())
render = web.template.render("tmpl/")


def templateNameToTitle(name):
  if name == "index": return ""
  title = name
  if "-" in title:
    title = title.replace("-", " ")
  return title.title()


class Index:


  def GET(self):
    with open("html/index.html", "r") as indexFile:
      return render.layout(
        "index",
        "HTM School Visualizations",
        indexFile.read()
      )



class Client:


  def GET(self, file):
    name = file.split(".")[0]
    path = "html/{}".format(file)
    with open(path, "r") as htmlFile:
      return render.layout(
        name,
        templateNameToTitle(name),
        htmlFile.read()
      )


def getSpDetails(requestInput, sp):
  kwargs = {}
  for param in SP_DETAILS:
    key = "get{}{}".format(param[:1].upper(), param[1:])
    kwargs[key] = param in requestInput and requestInput[param] == "true"
  state = sp.getCurrentState(**kwargs)
  # Compress any SDRs.
  return state


class SPInterface:


  def POST(self):
    global spWrappers
    params = json.loads(web.data())
    requestInput = web.input()
    savedSp = "save" in requestInput \
                  and requestInput["save"] == "true"
    sp = SP(**params)
    spId = str(uuid.uuid4()).split('-')[0]
    wrapper = SpWrapper(spId, sp, save=savedSp)
    spWrappers[spId] = wrapper
    web.header("Content-Type", "application/json")
    # Send back the SP id and any details about the initial state that the client
    # specified in the request's URL params.
    payload = {
      "id": spId,
    }
    spState = getSpDetails(requestInput, wrapper)
    for key in spState:
      payload[key] = spState[key]
    return json.dumps(payload)


  def PUT(self):
    requestStart = time.time()
    requestInput = web.input()
    encoding = web.data()
    # Every request must specify an SP id.
    if "id" not in requestInput:
      print "Request must include a spatial pooler id."
      return web.badrequest()
    # The SP id must be valid.
    spId = requestInput["id"]
    if spId not in spWrappers:
      print "Unknown SP id {}!".format(spId)
      return web.badrequest()

    sp = spWrappers[spId]
    # Learn by default, allow request input to specify.
    learn = True
    if "learn" in requestInput:
      learn = requestInput["learn"] == "true"
    print encoding
    # Decompress input encoding.
    inputArray = decompress(json.loads(encoding))

    print "Entering SP compute cycle | Learning: {}".format(learn)

    sp.compute(inputArray, learn)

    web.header("Content-Type", "application/json")

    response = getSpDetails(requestInput, sp)

    if sp.save:
      self.saveSpStateInBackground(sp)

    jsonOut = json.dumps(response)
    requestEnd = time.time()
    print("\tSP compute cycle took %g seconds" % (requestEnd - requestStart))
    return jsonOut


  @staticmethod
  def saveSpStateInBackground(spWrapper):
    p = multiprocessing.Process(target=saveStateToRedis, args=(spWrapper,))
    p.start()



class SPHistory:

  def GET(self, spId, columnIndex):
    sp = spWrappers[spId]
    connections = sp.getConnectionHistoryForColumn(columnIndex)
    permanences = sp.getPermanenceHistoryForColumn(columnIndex)
    return json.dumps({
      "connections": connections,
      "permanences": permanences
    })



if __name__ == "__main__":
  app.run()
