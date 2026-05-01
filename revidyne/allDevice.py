
from serial.tools import list_ports
from .serialcom import SerialCommander
import re, time
import re

def remove_trailing_number(s):
    # Use a regular expression to match a trailing number at the end of the string
    match = re.search(r'\d+$', s)

    if match:
        # If a match is found, remove the trailing number
        s = s[:match.start()]

    return s
    
def getCount(lst, pat):
    cnt = 0
    for i, it in enumerate(lst):
        if pat in it:
            cnt += 1

    addelement = pat + str(cnt)
    modified_elements = []
    modified_elements.append(addelement)
    
    lst.extend(modified_elements)

    return addelement, lst
    
    
class AllDevice:

  def __init__(self, spd=115200):
    self.devicenames=[]
    self.devices={}
    self.spd = spd
    enmu_ports = enumerate(list_ports.comports())
    port = []
    for n, (p, descriptor, hid) in enmu_ports:
      if re.findall(r"Ser", descriptor)  :
        if "wch" not in p:
            print(p)
            port.append(p)

    for m in port:
        serial_commander = SerialCommander(m, self.spd)  # Replace with your serial port and baud rate
        serial_commander.connect()
        time.sleep(2)
        serial_commander.send_command("*ID?")
        response = serial_commander.read_response()
        print(response)
        response, self.devicenames = getCount(self.devicenames, response) 
        print(response)
        self.devices[response]=Device(response, port=m, spd=self.spd)            

  def getAllDevice(self):
    return self.devices
       


class Device:
  def __init__(self, name, port, spd=115200):
      self.port = port
      self.name = name
      print(name)
      mod = __import__('.revidyne', fromlist=[name])

      klass = getattr(mod, remove_trailing_number(name))
      self.device=klass(port, spd)

  def getDevice(self):
     return self.device

