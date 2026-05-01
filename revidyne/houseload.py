import serial
from .serialcom import SerialCommander
import time
from traitlets import HasTraits, observe, Instance, Int

import re

def parse_command(cmd_name):
    # Match command name, optional >number, optional <number
    match = re.match(r'([a-zA-Z0-9_]+)(?:>(\d+))?(?:<(\d+))?', cmd_name)

    if match:
        command = match.group(1)  # Extract command name
        num_of_output = int(match.group(2)) if match.group(2) else 0  # Extract output count or default to 0
        num_of_input = int(match.group(3)) if match.group(3) else 0  # Extract input count or default to 0
        return command, num_of_output, num_of_input

    return cmd_name, 0, 0  # Default case: No symbols found


inPrompts = {'getAll': ["Kilowatt capacity: ", "Current KW level: ", "Load allocated: ", \
                        "Difference between allocated and used KW: ", "Carbon value: ",  \
                        "Renewability: ", "Current Power: "] ,
           'getLoads': ["h1 load: ", "h2 load: ", "h3 load: ", "h4 load: "],
            'getLoadVal':  ["Combined load: "] ,
             'getKW':         ["KW: "],
              'getCarbon': ["Carbon emission in ton: "]}

class houseload(HasTraits, SerialCommander):
    h1 = Int()
    h2 = Int()
    h3 = Int()
    h4 = Int()
    def __init__(self, COM, SP):
        self.cmdMenu = {}
        self.cmds = {}
        self.port = COM
        self.baud_rate = SP
        super(houseload, self).connect()
        time.sleep(2)
        self.set_up_cmds()

    def set_up_cmds(self):

        #self.send_command("getCommands")
        #cmd_name = self.read_response()

        # Protocol: send "getCommands", then read one command per line until "eoc".
        # Each line can include signature markers like "getKW<1" or "EPw>2".
        super(houseload, self).send_command("getCommands")

        while True:
            cmd_name = super(houseload, self).read_response()
            if not cmd_name:
                continue
            if cmd_name == "eoc":
                break

            curr_cmd, num_of_input, num_of_output = parse_command(cmd_name)
            self.cmds[curr_cmd] = Cmd(curr_cmd, num_of_input, num_of_output)
          

    def call(self, cmd_name):
        if cmd_name not in self.cmds:
            print(f"ERROR: '{cmd_name}' is not in cmd menu")
            return

        curr_cmd = self.cmds[cmd_name]

        if curr_cmd.in_arg == 0 and curr_cmd.out_arg == 0:
            self.send_command(cmd_name)
        elif curr_cmd.in_arg != 0:
            return self.read_cmd_message(cmd_name, False)
        elif curr_cmd.out_arg != 0:
            return self.read_cmd_message(cmd_name, True)            
        elif cmd_name == "setLoad":
            self.set_load()
        elif cmd_name == "setVolts":
            self.set_volts()
        elif cmd_name == "setMot":
            self.set_mot()
        elif cmd_name == "setKp":
            self.set_kp()
        elif cmd_name == "setKi":
            self.set_ki()
        elif cmd_name == "setKd":
            self.set_kd()

    @observe('h1', 'h2', 'h3', 'h4')
    def setlimits(self, value):
        self.send_command(f"setLimits\n{self.h1}\n{self.h2}\n{self.h3}\n{self.h4}")

    def setLimits(self, h1, h2, h3, h4):
        self.h1 = h1
        self.h2 = h2
        self.h3 = h3
        self.h4 = h4
        self.send_command(f"setLimits\n{self.h1}\n{self.h2}\n{self.h3}\n{self.h4}")


    def read_cmd_message(self, cmd_name, returnValue=False):
        if cmd_name not in self.cmds:
            print(f"ERROR: '{cmd_name}' is not in cmd menu")
            return

        count = self.cmds[cmd_name].in_arg+self.cmds[cmd_name].out_arg
        self.send_command(cmd_name)
        time.sleep(0.1)  # Wait for response to be received
        cnt=0
        for _ in range(count):
            response = self.read_response()
            print(inPrompts[cmd_name][cnt], response)
            cnt=cnt+1

    def list_cmds(self):
        return self.cmds

class Cmd:
    def __init__(self, name, in_arg, out_arg):
        self.name = name
        self.in_arg = in_arg
        self.out_arg = out_arg

#generator = GeneratorObj("/dev/cu.usbserial-110", 9600)
#generator.setup()  # Replace with your COM port and baud rate
#generator.call("init")
#generator.call("runRange")
# Call other commands as needed
#generator.call("off")  # For example, turning off the generator
