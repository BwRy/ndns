//
// DNS SERVER FOR THE NDNS LOAD BALANCER
//
// Performs load balancing using Round Robin/Dynamic/Hybrid strategy 
//

var dgram = require('dgram');
var ndns = require('../lib/ndns');
var util = require('util');
var p_type_syms = ndns.p_type_syms;


var BIND_PORT = 53;
var POLL_PORT = 5000;

// Zone file information
var zone = {}
// All domain names should be in lower case
addToTree(zone, ["in","aiesec"], 
                { '*' : [ 
                          { name: 'aiesec.in', rr: 'SOA', ttl: '86400', dclass: 'IN', value: 'ns1.bluehost.com. root.box481.bluehost.com. 2011031102 86400 7200 3600000 300'},
                          { name: 'aiesec.in', rr: 'TXT', ttl: '14400', dclass: 'IN', value: 'v=spf1 a mx ptr include:bluehost.com ?all' },
                          { name: 'aiesec.in', rr: 'NS', ttl: '86400', dclass: 'IN', value: 'ns1.bluehost.com.' },
                          { name: 'aiesec.in', rr: 'NS', ttl: '86400', dclass: 'IN', value: 'ns2.bluehost.com.' },
                          { name: 'aiesec.in', rr: 'MX', ttl: '14400', dclass: 'IN', value: '0 aiesec.in' },
                          { name: 'aiesec.in', rr: 'A', ttl: '14400', dclass: 'IN', value: ['74.220.219.81', '74.220.219.82','127.0.0.1','127.0.0.2'] , balance: 'dyn' },
                          { name: 'ns1.bluehost.com.', rr: 'A', ttl: '14400', dclass: 'IN', value: '127.0.0.1' },
                          { name: 'ns2.bluehost.com.', rr: 'A', ttl: '14400', dclass: 'IN', value: '127.0.0.2' },
                        ] } );
addToTree(zone, ["com","google"],
								{ '*' : [
													{ name: ['ns1.google.com','ns2.google.com','ns3.google.com','ns4.google.com'], rr: 'NS', ttl: '14400', dclass: 'IN', value: ['216.239.32.10','216.239.34.10','216.239.36.10','216.239.38.10'], index: 0, balance: 'rr' } 
												]
								} );									
addToTree(zone, ["in","ac","lnmiit","proxy"], 
                { '*' : [
                          { name: 'proxy.lnmiit.ac.in', rr:'A', ttl: '14400', dclass: 'IN', value: ['172.22.2.211','172.22.2.212'], index: 0, balance: 'rr' }
                        ] } );

// Add to tree function
function addToTree(tree, array , value){
  for(var i = 0, length = array.length; i < length; i++) {
    tree = tree[array[i]] = ((i == length-1)? value : (tree[array[i]] || {}));
  }
}

// Retrieve RR records
function getRR(name) {
  var labels = name.split('.');
  var root = zone;
  for(var index = labels.length-1; index >= 0; index--){
    // Case Insensitive Comparison logic
    var label = labels[index].toLowerCase();
    if(root[label] == null){
      console.log("Domain not found");
      break;
    } else {
    //console.log('->'+label);
      root = root[label];
    }
  }
  //console.log(util.inspect(root['*'].length)+ " records found");
  if (root != zone)
    return root['*'];
  else 
    return null;
}

// Check if this RR record should be returned for Question q
function checkQuestions(q, rr){
  var result = false;
  //console.log(p_type_syms[q.type] + " - " + util.inspect(rr['rr']));
  if( p_type_syms[q.type] == rr['rr']) {
    result = true;    
  }  else if ( q.type == 255 ) {
    result = true;
  }  else if ( q.type == 253 && (rr['rr'] == 'MB' || rr['rr'] == 'MG' || rr['rr'] == 'MR') ) {
      result = true;
   }
  return result;    
} 

// Add a RR record to response
function addRR(res, rr){
  //console.log("Adding "+ rr);
  if(rr['rr'] == 'SOA' ){
    var param = rr['value'].split(" ");
    res.addRR(rr['name'],
        rr['ttl'],
        rr['dclass'],
        rr['rr'], 
        param[0],   // MNAME - The <domain-name> of the name server that was the original or primary source of data for this zone
        param[1],   // RNAME - A <domain-name> which specifies the mailbox of the person responsible for this zone
        param[2],   // SERIAL - The unsigned 32 bit version number of the original copy of the zone. Zone transfers preserve this value. This value wraps and should be compared using sequence space arithmetic
        param[3],   // REFRESH - A 32 bit time interval that should elapse before the zone should be refreshed
        param[4],   // RETRY - A 32 bit time interval that should elapse before a failed refresh should be retried
        param[5]     // EXPIRE - A 32 bit time value that specifies the upper limit on the time interval that can elapse before the zone is no longer authoritative
        );
  }
  else if (rr['rr'] == 'HINFO' || rr['rr'] == 'MINFO' || rr['rr'] == 'MX' ){
    var param = rr['value'].split(" ");
    res.addRR(rr['name'],
        rr['ttl'],
        rr['dclass'],
        rr['rr'],
        param[0],   /* HINFO : CPU - A <character-string> which specifies the CPU type
                       MINFO : RMAILBX -  <domain-name> which specifies a mailbox which is
                       responsible for the mailing list or mailbox.  If this
                       domain name names the root, the owner of the MINFO RR is
                       responsible for itself.  Note that many existing mailing
                       lists use a mailbox X-request for the RMAILBX field of
                       mailing list X, e.g., Msgroup-request for Msgroup.  This
                       field provides a more general mechanism.
                       MX : PREFERENCE -  A 16 bit integer which specifies the preference given to
                       this RR among others at the same owner.  Lower values
                       are preferred.
                     */
        param[1]    /* HINFO : OS - A <character-string> which specifies the operating system type
                       MINFO : EMAILBX - A <domain-name> which specifies a mailbox which is to
                       receive error messages related to the mailing list or
                       mailbox specified by the owner of the MINFO RR (similar
                       to the ERRORS-TO: field which has been proposed).  If
                       this domain name names the root, errors should be
                       returned to the sender of the message.
                       MX : EXCHANGE -   <domain-name> which specifies a host willing to act as
                       a mail exchange for the owner name.
                     */
      );
  }
  else if (rr['rr'] == 'WKS' ){
    var param = rr['value'].split(" ");
    res.addRR(rr['name'],
        rr['ttl'],
        rr['dclass'],
        rr['rr'],
        param[0],   // An 32 bit Internet address
        param[1],    // An 8 bit IP protocol number
        param[2]);  // A variable length bit map. The bit map must be a multiple of 8 bits long

  }
  else {
		// No load balancing
 	  if (rr['balance'] == null){
		  res.addRR(rr['name'],
    		        rr['ttl'],
        	      rr['dclass'],
          	    rr['rr'],
            	  rr['value']);
    }
		//Implementation of Round Robin scheduling
    else if (rr['balance'] == 'rr' && rr['value'] instanceof Array )  {
			
			if(	rr['index'] == null) rr['index'] = 0;
			
			var index = parseInt(rr['index']);
			res.addRR((rr['name'] instanceof Array)? rr['name'][index]: rr['name'],
								rr['ttl'],
								rr['dclass'],
								rr['rr'],
								rr['value'][index]);
			rr['index'] = (index+1)%rr['value'].length;
		} 
		//Implementation of Dynamic Load Balancing
		else if (rr['balance'] == 'dyn' && rr['value'] instanceof Array ) {

			if(	rr['index'] == null) rr['index'] = 0;
			var index = parseInt(rr['index']);
			
			var fast_server = ndns.poller.server.getServerWithMinLoad(rr['name']);
			console.log(rr['name'] + " fast server : " + fast_server );
			
			
			// Fallback to Round Robin if no dynamic load information is available
			if(fast_server == undefined){
				
				res.addRR(rr['name'],
									rr['ttl'],
									rr['dclass'],
									rr['rr'],
									rr['value'][index]);
				
				rr['index'] = (index+1)%rr['value'].length;
			} else {
				
				if(fast_server != rr['value'][index]) {
					//Find new index	
					var found = false;
					for( var i = 0; i < rr['value'].length; i++){
						if(rr['value'][i] == fast_server){
							found = true;
							index = i;
							break;
						}
					}
					if(found) 
						rr['index'] == index;
					else 
						console.log("ERROR! IP DOES NOT EXIST IN ZONE RECORDS");

				}

				// Return value at index			
				res.addRR(rr['name'],
									rr['ttl'],
									rr['dclass'],
									rr['rr'],
									rr['value'][index]);
			}
			//console.log(util.inspect(fast_server));
		} 
  }
}
// Create DNS RR response
function createResponse (req, res, root) {

  var count = new Array(0,0,0);

  // Add RR to response


  // Iterate over each section - 0 - Answer, 1 - Authority, 2 -Additional of DNS Response
  for( var i = 0; i < 3; i++) {

    // Iterate over each question
    for( var j = 0; j < req.q.length; j++){
    
      // Iterate over each record
      for( var k = 0; k < root.length; k++) {
        //console.log("Section: "+i+", Question: "+j+", Record: "+k);
        // Check if this RR should be returned for the DNS Query Question
        // Returns answers to query questions
        if(checkQuestions(req.q[j], root[k]) && i == 0) {
          addRR(res,root[k]);
          count[i]++;
        }  
        else if( i == 1 && root[k]['rr'] == 'NS'){
          addRR(res,root[k]);
          count[i]++;
        }
        else if ( i == 2 && root[k]['name'] != req.q[j].name ){
          addRR(res,root[k]);
          count[i]++;
        }
      }
    }
  }
  res.header.qr = 1;        //DNS query - 0 , DNS response - 1  
  res.header.ra = 1;        //recursion available
  res.header.aa = 1;        //authoritative answer
  res.header.rd = 0;        //recursion desired
  res.header.qdcount = req.q.length;    //Question Count

  res.header.ancount = count[0];    //Answer Count
  res.header.nscount = count[1];    //Nameserver Record Count
  res.header.arcount = count[2];    //Additional Record Count

  //console.log(util.inspect(res));
}


// DNS Server implementation

var dns_server = ndns.createServer('udp4');

// Polling Server Startup
ndns.poller.server.createServer(POLL_PORT);
ndns.poller.client.startPoller('127.0.0.1', POLL_PORT, 'aiesec.in');

dns_server.on("request", function(req, res) {
  res.setHeader(req.header);

  for (var i = 0; i < req.q.length; i++)
    res.addQuestion(req.q[i]);
   //console.log(util.inspect(req.q)); 
  if (req.q.length > 0) {
    var name = req.q[0].name;
    if (name == ".")
      name = "";

    var root = getRR(name);
   	if(root) 
	    createResponse(req, res, root)
		else{
			res.header.rcode = 0x8;
			res.header.qr = 1;
			res.header.ra = 1;
			res.header.aa = 0;
			res.header.rd = 0;
			res.header.ancount = 0;
			res.header.nscount = 0;
			res.header.arcount = 0;
		}
  }
  res.send();
  //console.log("Response sent");
});

dns_server.bind(BIND_PORT);

