import serial, time
from serial.tools import list_ports

class SerialCommander:
    def __init__(self, port, baud_rate):
        self.port = port
        self.baud_rate = baud_rate
        self.serial_connection = None

    def connect(self):
        try:
            self.serial_connection = serial.Serial(self.port, self.baud_rate, timeout=2)
           # print(f"super Connected to {self.port} at {self.baud_rate} baud rate.")
            time.sleep(0.1)
            self.serial_connection.parity  = 'N'
            self.serial_connection.stopbits = 1
            self.serial_connection.write_timeout = 1 
            self.serial_connection.dsrdtr = True
            self.serial_connection.rtscts = True
            time.sleep(0.1)
            self.serial_connection.dsrdtr = False
            self.serial_connection.rtscts = False
            self.serial_connection.reset_input_buffer()
            self.serial_connection.reset_output_buffer()
            
        except serial.SerialException as e:
            print(f"Error: {e}")

    def disconnect(self):
        if self.serial_connection:
            self.serial_connection.close()
            print(f"Disconnected from {self.port}.")

    def send_command(self, command):
        if self.serial_connection:
            try:
                self.serial_connection.write((command + "\n").encode())
            #    print(f"Sent command: {command}")
            except serial.SerialException as e:
                print(f"Error sending command: {e}")
                
    def read_response(self):
        response = ""
        if self.serial_connection:
            try:
                response = self.serial_connection.readline().decode().strip()
            #    print(f"Received response: {response}")
            except serial.SerialException as e:
                print(f"Error reading response: {e}")
        return response

    
# Example usage:

from serial.tools import list_ports
import re
enmu_ports = enumerate(list_ports.comports())
port = []

for n, (p, descriptor, hid) in enmu_ports:
    #print(p, descriptor, hid)
    #print(p)
    if re.findall(r"Ser", descriptor):
        print(p)
        port.append(p)

print(port)

for m in port:
    serial_commander = SerialCommander(m, 9600)  # Replace with your serial port and baud rate
    serial_commander.connect()
    time.sleep(2)
    serial_commander.send_command("*ID?")
    response = serial_commander.read_response()

    if (response == "houseload"):
        print("found: ", response)
        serial_commander.send_command("getVal")
        response = serial_commander.read_response()
        print("commands", response)
    
    serial_commander.disconnect()
